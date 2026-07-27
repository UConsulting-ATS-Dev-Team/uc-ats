import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import memberRoutes from './member.js';
import prisma from '../prismaClient.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    recruitingCycle: { findFirst: vi.fn() },
    meetingSlot: { create: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    groups: { findMany: vi.fn() }
  }
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: 'member-1', email: 'member@uconsulting.com', fullName: 'Member User', role: 'MEMBER' };
    next();
  },
  requireAdmin: (req, res, next) => next()
}));

vi.mock('../services/slackService.js', () => ({
  sendSlackMessage: vi.fn().mockResolvedValue({ success: true })
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendMeetingCancellationEmail: vi.fn().mockResolvedValue({ success: true })
}));

vi.mock('../services/meetingComms.js', () => ({
  sendAndLogMeetingCommunication: vi.fn((fn) => fn()),
  MEETING_COMM_SUBJECTS: {
    CONFIRMATION: 'Meeting signup confirmation',
    HOST_NOTIFICATION: (name) => `New signup for ${name}`,
    CANCELLATION: 'Meeting cancellation',
    CANCELLATION_TO_HOST: 'Signup cancelled'
  }
}));

describe('member meeting slot routes', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
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
    vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
  });

  const activeCycle = {
    id: 'cycle-1',
    name: 'Winter 2026',
    isActive: true,
    startDate: new Date('2026-01-05T00:00:00Z'),
    endDate: new Date('2026-01-20T00:00:00Z')
  };

  function post(path, body = {}) {
    return fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  describe('POST /api/member/meeting-slots', () => {
    it('creates a slot in the active cycle and returns it', async () => {
      prisma.recruitingCycle.findFirst.mockResolvedValue(activeCycle);
      prisma.meetingSlot.create.mockImplementation(({ data }) => Promise.resolve({ id: 'slot-1', ...data }));

      const res = await post('/api/member/meeting-slots', {
        location: 'Student Union',
        startTime: '2026-01-15T10:00',
        endTime: '2026-01-15T11:00',
        capacity: 3
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.location).toBe('Student Union');
      expect(body.capacity).toBe(3);
      expect(body.memberId).toBe('member-1');

      const createData = prisma.meetingSlot.create.mock.calls[0][0].data;
      expect(createData.location).toBe('Student Union');
      expect(createData.capacity).toBe(3);
      expect(createData.startTime.toISOString()).toBe('2026-01-15T18:00:00.000Z');
    });

    it('rejects a slot that starts outside the active cycle', async () => {
      prisma.recruitingCycle.findFirst.mockResolvedValue(activeCycle);

      const res = await post('/api/member/meeting-slots', {
        location: 'Future Room',
        startTime: '2026-02-01T10:00',
        endTime: '2026-02-01T11:00',
        capacity: 2
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/active recruiting cycle/i);
      expect(prisma.meetingSlot.create).not.toHaveBeenCalled();
    });

    it('rejects a slot that starts in the past', async () => {
      prisma.recruitingCycle.findFirst.mockResolvedValue(activeCycle);

      const res = await post('/api/member/meeting-slots', {
        location: 'Old Room',
        startTime: '2026-01-09T10:00',
        endTime: '2026-01-09T11:00',
        capacity: 2
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/future/i);
      expect(prisma.meetingSlot.create).not.toHaveBeenCalled();
    });

    it('rejects creation when there is no active recruiting cycle', async () => {
      prisma.recruitingCycle.findFirst.mockResolvedValue(null);

      const res = await post('/api/member/meeting-slots', {
        location: 'Student Union',
        startTime: '2026-01-15T10:00',
        endTime: '2026-01-15T11:00',
        capacity: 2
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no active recruiting cycle/i);
      expect(prisma.meetingSlot.create).not.toHaveBeenCalled();
    });

    it('requires location and start time', async () => {
      const res = await post('/api/member/meeting-slots', { endTime: '2026-01-15T11:00' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/location and start time/i);
    });
  });
});
