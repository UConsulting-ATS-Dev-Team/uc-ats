import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import publicRoutes from './public.js';
import prisma from '../prismaClient.js';

function createMockPrisma() {
  const defaultExport = {
    recruitingCycle: { findFirst: vi.fn() },
    meetingSlot: { findMany: vi.fn(), findUnique: vi.fn() },
    meetingSignup: { findMany: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn() },
    $queryRaw: vi.fn()
  };
  defaultExport.$transaction = vi.fn(async (callback) => callback(defaultExport));
  return { default: defaultExport };
}

vi.mock('../prismaClient.js', () => createMockPrisma());

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: 'user-1', email: 'candidate@example.com', fullName: 'Candidate One', studentId: '123456789' };
    next();
  },
  requireAdmin: (req, res, next) => next()
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendMeetingSignupConfirmation: vi.fn().mockResolvedValue({ success: true }),
  sendMeetingSignupNotification: vi.fn().mockResolvedValue({ success: true }),
  sendMeetingCancellationToMember: vi.fn().mockResolvedValue({ success: true })
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

describe('public meeting slot routes', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api', publicRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  const activeCycle = {
    id: 'cycle-1',
    name: 'Winter 2026',
    isActive: true,
    startDate: new Date('2026-01-05T00:00:00Z'),
    endDate: new Date('2026-01-20T00:00:00Z')
  };

  function get(path) {
    return fetch(`http://localhost:${port}${path}`);
  }

  function post(path, body = {}) {
    return fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  describe('GET /api/meeting-slots', () => {
    it('returns an empty array when there is no active recruiting cycle', async () => {
      prisma.recruitingCycle.findFirst.mockResolvedValue(null);

      const res = await get('/api/meeting-slots');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
      expect(prisma.meetingSlot.findMany).not.toHaveBeenCalled();
    });

    it('returns an empty array when the active cycle has no date boundaries', async () => {
      prisma.recruitingCycle.findFirst.mockResolvedValue({ id: 'cycle-1', isActive: true });

      const res = await get('/api/meeting-slots');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
      expect(prisma.meetingSlot.findMany).not.toHaveBeenCalled();
    });

    it('returns only future, available slots within the active cycle', async () => {
      vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
      prisma.recruitingCycle.findFirst.mockResolvedValue(activeCycle);

      const host = { id: 'member-1', fullName: 'Alex Host', profileImage: '/api/uploads/profile-images/alex.png' };
      const slots = [
        {
          id: 'slot-past',
          startTime: new Date('2026-01-09T18:00:00Z'),
          endTime: new Date('2026-01-09T19:00:00Z'),
          location: 'Old',
          capacity: 2,
          member: host,
          signups: []
        },
        {
          id: 'slot-active',
          startTime: new Date('2026-01-20T22:00:00Z'), // 2 PM LA on the cycle end date
          endTime: new Date('2026-01-20T23:00:00Z'),
          location: 'Student Union',
          capacity: 2,
          member: host,
          signups: [{ id: 'su-1' }]
        },
        {
          id: 'slot-future-cycle',
          startTime: new Date('2026-02-01T18:00:00Z'),
          endTime: new Date('2026-02-01T19:00:00Z'),
          location: 'Future',
          capacity: 2,
          member: host,
          signups: []
        },
        {
          id: 'slot-full',
          startTime: new Date('2026-01-15T18:00:00Z'),
          endTime: new Date('2026-01-15T19:00:00Z'),
          location: 'Full Room',
          capacity: 2,
          member: host,
          signups: [{ id: 'su-1' }, { id: 'su-2' }]
        }
      ];
      prisma.meetingSlot.findMany.mockImplementation(({ where }) => {
        const { gte, lt } = where.startTime;
        return slots.filter(s => s.startTime >= gte && s.startTime < lt);
      });

      const res = await get('/api/meeting-slots');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('slot-active');
      expect(body[0].memberName).toBe('Alex Host');
      expect(body[0].memberProfileImage).toBe('/api/uploads/profile-images/alex.png');
      expect(body[0].remaining).toBe(1);
      expect(body[0]).not.toHaveProperty('memberEmail');

      const where = prisma.meetingSlot.findMany.mock.calls[0][0].where;
      expect(where.startTime.gte.toISOString()).toBe(new Date('2026-01-10T00:00:00Z').toISOString());
      expect(where.startTime.lt.toISOString()).toBe(new Date('2026-01-21T08:00:00Z').toISOString());
    });

    it('does not expose member email or other private fields', async () => {
      vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
      prisma.recruitingCycle.findFirst.mockResolvedValue(activeCycle);
      prisma.meetingSlot.findMany.mockResolvedValue([
        {
          id: 'slot-1',
          startTime: new Date('2026-01-15T18:00:00Z'),
          endTime: new Date('2026-01-15T19:00:00Z'),
          location: 'Student Union',
          capacity: 2,
          member: {
            id: 'member-1',
            fullName: 'Alex Host',
            email: 'alex@uconsulting.com',
            profileImage: '/api/uploads/profile-images/alex.png',
            phoneNumber: '555-555-5555'
          },
          signups: []
        }
      ]);

      const res = await get('/api/meeting-slots');
      const body = await res.json();
      expect(body[0].memberProfileImage).toBe('/api/uploads/profile-images/alex.png');
      expect(body[0]).not.toHaveProperty('memberEmail');
      expect(body[0]).not.toHaveProperty('email');
      expect(body[0]).not.toHaveProperty('phoneNumber');
    });
  });

  describe('POST /api/meeting-slots/:id/signup', () => {
    beforeEach(() => {
      vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
      prisma.$queryRaw.mockResolvedValue([activeCycle]);
      prisma.user.findUnique.mockResolvedValue(null);
    });

    it('creates a signup for an eligible slot and returns success', async () => {
      prisma.meetingSlot.findUnique.mockResolvedValue({
        id: 'slot-1',
        startTime: new Date('2026-01-15T18:00:00Z'),
        endTime: new Date('2026-01-15T19:00:00Z'),
        location: 'Student Union',
        capacity: 2,
        signups: [],
        member: { fullName: 'Alex Host', email: 'alex@uconsulting.com' }
      });
      prisma.meetingSignup.findMany.mockResolvedValue([]);
      prisma.meetingSignup.create.mockResolvedValue({ id: 'signup-1', fullName: 'Candidate One', email: 'candidate@example.com' });

      const res = await post('/api/meeting-slots/slot-1/signup');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.needsAccount).toBe(true);

      expect(prisma.meetingSignup.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ slotId: 'slot-1', fullName: 'Candidate One', email: 'candidate@example.com', studentId: '123456789' })
      });
    });

    it('rejects signup when there is no active recruiting cycle', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const res = await post('/api/meeting-slots/slot-1/signup');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no active recruiting cycle/i);
      expect(prisma.meetingSlot.findUnique).not.toHaveBeenCalled();
    });

    it('rejects signup for a slot outside the active cycle', async () => {
      prisma.meetingSlot.findUnique.mockResolvedValue({
        id: 'slot-stale',
        startTime: new Date('2026-02-01T18:00:00Z'),
        endTime: new Date('2026-02-01T19:00:00Z'),
        location: 'Future',
        capacity: 2,
        signups: [],
        member: { fullName: 'Alex Host', email: 'alex@uconsulting.com' }
      });

      const res = await post('/api/meeting-slots/slot-stale/signup');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/not part of the active recruiting cycle/i);
    });

    it('rejects signup for a past slot', async () => {
      prisma.meetingSlot.findUnique.mockResolvedValue({
        id: 'slot-past',
        startTime: new Date('2026-01-09T18:00:00Z'),
        endTime: new Date('2026-01-09T19:00:00Z'),
        location: 'Old',
        capacity: 2,
        signups: [],
        member: { fullName: 'Alex Host', email: 'alex@uconsulting.com' }
      });

      const res = await post('/api/meeting-slots/slot-past/signup');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/already passed/i);
    });

    it('rejects signup for a full slot', async () => {
      prisma.meetingSlot.findUnique.mockResolvedValue({
        id: 'slot-full',
        startTime: new Date('2026-01-15T18:00:00Z'),
        endTime: new Date('2026-01-15T19:00:00Z'),
        location: 'Full Room',
        capacity: 2,
        signups: [{ id: 'su-1' }, { id: 'su-2' }],
        member: { fullName: 'Alex Host', email: 'alex@uconsulting.com' }
      });

      const res = await post('/api/meeting-slots/slot-full/signup');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/full/i);
    });

    it('enforces one signup per active cycle', async () => {
      prisma.meetingSlot.findUnique.mockResolvedValue({
        id: 'slot-2',
        startTime: new Date('2026-01-18T18:00:00Z'),
        endTime: new Date('2026-01-18T19:00:00Z'),
        location: 'Room B',
        capacity: 2,
        signups: [{ id: 'su-1' }],
        member: { fullName: 'Alex Host', email: 'alex@uconsulting.com' }
      });
      prisma.meetingSignup.findMany.mockResolvedValue([
        { id: 'existing-1', slot: { startTime: new Date('2026-01-15T18:00:00Z') } }
      ]);

      const res = await post('/api/meeting-slots/slot-2/signup');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/one meeting slot per cycle/i);
    });
  });
});
