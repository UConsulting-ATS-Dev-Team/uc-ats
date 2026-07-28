import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import adminRoutes from './admin.js';
import memberRoutes from './member.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    recruitingCycle: { findFirst: vi.fn() },
    interview: { findUnique: vi.fn(), findMany: vi.fn() },
    interviewSlot: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    interviewSlotSignup: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn((fn) => fn(prisma)),
  },
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendInterviewSlotSignupConfirmation: vi.fn(() => Promise.resolve({ success: true, messageId: 'msg-1' })),
}));

import { sendInterviewSlotSignupConfirmation } from '../services/emailNotifications.js';

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin User' };
const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'member@example.com', fullName: 'Member User' };
const candidateUser = { id: 'candidate-1', role: 'USER', isActive: true, email: 'candidate@example.com', fullName: 'Candidate User' };
const activeCycle = { id: 'cycle-1', name: 'Fall 2026', isActive: true };

const coffeeChatInterview = {
  id: 'iv-1',
  title: 'Coffee Chat Round',
  interviewType: 'COFFEE_CHAT',
  cycleId: activeCycle.id,
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: new Date('2026-10-07T00:00:00Z'),
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

function buildApp(routes) {
  const app = express();
  app.use(express.json());
  app.use('/', routes);
  const server = app.listen(0);
  const port = server.address().port;
  return { app, server, port };
}

function slotFixture(overrides = {}) {
  return {
    id: 'slot-1',
    interviewId: coffeeChatInterview.id,
    startTime: new Date('2026-10-02T14:00:00Z'),
    endTime: new Date('2026-10-02T15:00:00Z'),
    capacity: 2,
    ...overrides,
  };
}

function signupFixture(overrides = {}) {
  return {
    id: 'signup-1',
    slotId: 'slot-1',
    userId: memberUser.id,
    signedUpAt: new Date(),
    confirmationStatus: 'PENDING',
    confirmationError: null,
    confirmationSentAt: null,
    removedAt: null,
    removedBy: null,
    user: { id: memberUser.id, fullName: memberUser.fullName, email: memberUser.email },
    slot: {
      ...slotFixture(),
      interview: { title: coffeeChatInterview.title, interviewType: coffeeChatInterview.interviewType },
    },
    ...overrides,
  };
}

describe('Interview slot routes', () => {
  let adminApp;
  let memberApp;
  let adminPort;
  let memberPort;
  let adminServer;
  let memberServer;

  beforeAll(() => {
    ({ app: adminApp, server: adminServer, port: adminPort } = buildApp(adminRoutes));
    ({ app: memberApp, server: memberServer, port: memberPort } = buildApp(memberRoutes));
  });

  afterAll(async () => {
    await new Promise((resolve) => adminServer.close(resolve));
    await new Promise((resolve) => memberServer.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user = { findUnique: vi.fn() };
    prisma.user.findUnique.mockImplementation(({ where: { id } }) => {
      if (id === adminUser.id) return adminUser;
      if (id === memberUser.id) return memberUser;
      if (id === candidateUser.id) return candidateUser;
      return null;
    });
    prisma.recruitingCycle.findFirst.mockResolvedValue(activeCycle);
    prisma.interview.findUnique.mockResolvedValue(coffeeChatInterview);
    prisma.interview.findMany.mockResolvedValue([coffeeChatInterview]);
    prisma.interviewSlot.create.mockResolvedValue(slotFixture());
    prisma.interviewSlot.update.mockResolvedValue(slotFixture());
    prisma.interviewSlot.delete.mockResolvedValue({});
    prisma.interviewSlot.findUnique.mockResolvedValue({ ...slotFixture(), interview: coffeeChatInterview, signups: [] });
    prisma.interviewSlot.findMany.mockResolvedValue([slotFixture()]);
    prisma.interviewSlot.findFirst.mockResolvedValue(null);
    prisma.interviewSlotSignup.count.mockResolvedValue(0);
    prisma.interviewSlotSignup.findFirst.mockResolvedValue(null);
    prisma.interviewSlotSignup.create.mockResolvedValue(signupFixture());
    prisma.interviewSlotSignup.update.mockResolvedValue(signupFixture({ confirmationStatus: 'SENT' }));
    prisma.interviewSlotSignup.delete.mockResolvedValue({});
    sendInterviewSlotSignupConfirmation.mockResolvedValue({ success: true, messageId: 'msg-1' });
  });

  describe('Admin coverage endpoints', () => {
    async function get(url, token = tokenFor(adminUser)) {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      return fetch(`http://localhost:${adminPort}${url}`, { headers });
    }

    async function post(url, body, token = tokenFor(adminUser)) {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      return fetch(`http://localhost:${adminPort}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    it('rejects unauthenticated coverage requests', async () => {
      const res = await get('/interviews/iv-1/slots', null);
      expect(res.status).toBe(401);
    });

    it('rejects non-admin coverage requests', async () => {
      const res = await get('/interviews/iv-1/slots', tokenFor(memberUser));
      expect(res.status).toBe(403);
    });

    it('returns coverage for a supported active-cycle interview', async () => {
      const slot = slotFixture();
      prisma.interviewSlot.findMany.mockResolvedValue([{ ...slot, signups: [], _count: { signups: 0 } }]);

      const res = await get('/interviews/iv-1/slots');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.interview.id).toBe('iv-1');
      expect(body.slots[0].remainingSeats).toBe(2);
    });

    it('rejects coverage for unsupported interview types', async () => {
      prisma.interview.findUnique.mockResolvedValue({ ...coffeeChatInterview, interviewType: 'FINAL_ROUND' });
      const res = await get('/interviews/iv-1/slots');
      expect(res.status).toBe(400);
    });

    it('rejects coverage for cross-cycle interviews', async () => {
      prisma.interview.findUnique.mockResolvedValue({ ...coffeeChatInterview, cycleId: 'other-cycle' });
      const res = await get('/interviews/iv-1/slots');
      expect(res.status).toBe(400);
    });

    it('creates a slot with valid input', async () => {
      const res = await post('/interviews/iv-1/slots', { slots: [{ startTime: '2026-10-02T07:00', endTime: '2026-10-02T08:00', capacity: 2 }] });
      expect(res.status).toBe(201);
      expect(prisma.interviewSlot.create).toHaveBeenCalled();
    });

    it('rejects overlapping slots', async () => {
      prisma.interviewSlot.findFirst.mockResolvedValue(slotFixture());
      const res = await post('/interviews/iv-1/slots', { slots: [{ startTime: '2026-10-02T07:30', endTime: '2026-10-02T08:30', capacity: 2 }] });
      expect(res.status).toBe(409);
      expect(prisma.interviewSlot.create).not.toHaveBeenCalled();
    });

    it('rejects invalid capacity and intervals', async () => {
      const res1 = await post('/interviews/iv-1/slots', { slots: [{ startTime: '2026-10-02T08:00', endTime: '2026-10-02T07:00', capacity: 2 }] });
      expect(res1.status).toBe(400);
      const res2 = await post('/interviews/iv-1/slots', { slots: [{ startTime: '2026-10-02T07:00', endTime: '2026-10-02T08:00', capacity: 0 }] });
      expect(res2.status).toBe(400);
    });

    it('removes a signup and records the admin', async () => {
      const signup = signupFixture();
      prisma.interviewSlotSignup.findUnique.mockResolvedValue(signup);
      prisma.interviewSlotSignup.update.mockResolvedValue({ ...signup, removedAt: new Date(), removedBy: adminUser.id });

      const res = await fetch(`http://localhost:${adminPort}/interviews/signups/${signup.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenFor(adminUser)}` },
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.removedBy).toBe(adminUser.id);
      expect(prisma.interviewSlotSignup.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: signup.id },
          data: expect.objectContaining({ removedBy: adminUser.id }),
        })
      );
    });

    it('retries a failed confirmation email', async () => {
      const signup = signupFixture({ confirmationStatus: 'FAILED', confirmationError: 'SMTP error' });
      prisma.interviewSlotSignup.findUnique.mockResolvedValue(signup);
      const res = await post(`/interviews/signups/${signup.id}/retry-confirmation`, {});
      expect(res.status).toBe(200);
      expect(sendInterviewSlotSignupConfirmation).toHaveBeenCalled();
      expect(prisma.interviewSlotSignup.update).toHaveBeenCalled();
    });
  });

  describe('Member signup endpoints', () => {
    async function get(url, token = tokenFor(memberUser)) {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      return fetch(`http://localhost:${memberPort}${url}`, { headers });
    }

    async function post(url, body, token = tokenFor(memberUser)) {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      return fetch(`http://localhost:${memberPort}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    it('lists slots grouped by interview for the active cycle', async () => {
      const slot = slotFixture();
      prisma.interview.findMany.mockResolvedValue([{
        ...coffeeChatInterview,
        slots: [{ ...slot, signups: [], _count: { signups: 0 } }],
      }]);

      const res = await get('/interviews/slots');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0].slots[0].remainingSeats).toBe(2);
    });

    it('rejects signup by candidates', async () => {
      const res = await post('/interviews/slots/slot-1/signup', {}, tokenFor(candidateUser));
      expect(res.status).toBe(403);
    });

    it('creates a signup and sends a confirmation email outside the transaction', async () => {
      const res = await post('/interviews/slots/slot-1/signup', {});
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.signup.confirmationStatus).toBe('SENT');
      expect(sendInterviewSlotSignupConfirmation).toHaveBeenCalled();
      expect(prisma.interviewSlotSignup.update).toHaveBeenCalled();
    });

    it('returns 409 when slot is full', async () => {
      const fullSlot = { ...slotFixture(), capacity: 1 };
      prisma.interviewSlot.findUnique.mockResolvedValue({ ...fullSlot, interview: coffeeChatInterview, signups: [] });
      prisma.interviewSlotSignup.count.mockResolvedValue(1);

      const res = await post('/interviews/slots/slot-1/signup', {});
      expect(res.status).toBe(409);
    });

    it('returns 409 for overlapping member signups and allows adjacent boundaries', async () => {
      const existing = signupFixture({
        slot: {
          ...slotFixture(),
          startTime: new Date('2026-10-02T15:00:00Z'),
          endTime: new Date('2026-10-02T16:00:00Z'),
          interview: { cycleId: activeCycle.id },
        },
      });
      prisma.interviewSlotSignup.findFirst.mockResolvedValueOnce(existing).mockResolvedValueOnce(null);

      // Overlapping request at 15:30-16:30 should conflict
      const res1 = await post('/interviews/slots/slot-1/signup', {});
      expect(res1.status).toBe(409);

      // Adjacent request at 13:00-14:00 (end == existing.start) should be allowed
      prisma.interviewSlot.findUnique.mockResolvedValue({
        ...slotFixture({ startTime: new Date('2026-10-02T13:00:00Z'), endTime: new Date('2026-10-02T14:00:00Z') }),
        interview: coffeeChatInterview,
        signups: [],
      });
      const res2 = await post('/interviews/slots/slot-1/signup', {});
      expect(res2.status).toBe(201);
    });

    it('returns 409 for duplicate signups', async () => {
      const err = new Error('Unique constraint failed');
      err.code = 'P2002';
      prisma.interviewSlotSignup.create.mockRejectedValueOnce(err);

      const res = await post('/interviews/slots/slot-1/signup', {});
      expect(res.status).toBe(409);
    });

    it('persists failed email status without undoing the reservation', async () => {
      sendInterviewSlotSignupConfirmation.mockResolvedValueOnce({ success: false, error: 'SMTP down' });
      prisma.interviewSlotSignup.update.mockResolvedValueOnce(signupFixture({ confirmationStatus: 'FAILED', confirmationError: 'SMTP down' }));
      const res = await post('/interviews/slots/slot-1/signup', {});
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.signup.confirmationStatus).toBe('FAILED');
      expect(body.emailResult.success).toBe(false);
    });

    it('allows a member to cancel their own signup', async () => {
      const signup = signupFixture();
      prisma.interviewSlotSignup.findUnique.mockResolvedValue(signup);
      const res = await fetch(`http://localhost:${memberPort}/interviews/signups/${signup.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenFor(memberUser)}` },
      });
      expect(res.status).toBe(200);
      expect(prisma.interviewSlotSignup.delete).toHaveBeenCalledWith({ where: { id: signup.id } });
    });
  });

  describe('Concurrency and retry behavior', () => {
    async function postMember(url, body) {
      return fetch(`http://localhost:${memberPort}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(memberUser)}` },
        body: JSON.stringify(body),
      });
    }

    it('retries a serializable transaction failure and succeeds', async () => {
      let attempts = 0;
      prisma.$transaction.mockImplementation(async (fn) => {
        attempts += 1;
        if (attempts < 3) {
          const err = new Error('serialization failure');
          err.code = 'P2034';
          throw err;
        }
        return fn(prisma);
      });

      const res = await postMember('/interviews/slots/slot-1/signup', {});
      expect(res.status).toBe(201);
      expect(attempts).toBe(3);
      expect(sendInterviewSlotSignupConfirmation).toHaveBeenCalledTimes(1);
      expect(prisma.interviewSlotSignup.create).toHaveBeenCalledTimes(1);
    });

    it('only sends one confirmation attempt per successful signup under retry', async () => {
      let attempts = 0;
      prisma.$transaction.mockImplementation(async (fn) => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('serialization failure');
          err.code = 'P2034';
          throw err;
        }
        return fn(prisma);
      });

      const res = await postMember('/interviews/slots/slot-1/signup', {});
      expect(res.status).toBe(201);
      expect(sendInterviewSlotSignupConfirmation).toHaveBeenCalledTimes(1);
    });
  });
});
