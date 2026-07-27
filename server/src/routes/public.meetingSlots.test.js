import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import publicRoutes from './public.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    recruitingCycle: { findFirst: vi.fn() },
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    meetingSlot: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    meetingSignup: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendMeetingSignupConfirmation: vi.fn().mockResolvedValue(),
  sendMeetingSignupNotification: vi.fn().mockResolvedValue(),
  sendMeetingCancellationToMember: vi.fn().mockResolvedValue(),
}));

vi.mock('../services/meetingComms.js', () => ({
  sendAndLogMeetingCommunication: vi.fn((fn) => fn()),
  MEETING_COMM_SUBJECTS: {
    CONFIRMATION: 'CONFIRMATION',
    CANCELLATION: 'CANCELLATION',
    HOST_NOTIFICATION: (candidateName) => `${candidateName} signed up for your Get to Know UC slot`,
  },
}));

vi.mock('../services/google/meetingSlotCalendar.js', () => ({
  syncMeetingSlotCalendar: vi.fn(),
  calendarSyncResponse: vi.fn((result) => ({
    status: result.status,
    eventId: result.eventId || null,
    error: result.success ? null : result.error,
    warning: result.success ? null : result.error,
    retryAt: null,
  })),
}));

import prisma from '../prismaClient.js';
import { syncMeetingSlotCalendar } from '../services/google/meetingSlotCalendar.js';

const CANDIDATE = { id: 'user-1', email: 'candidate@example.com', fullName: 'Candidate', studentId: '123456789', role: 'USER' };
const SLOT = {
  id: 'slot-1',
  memberId: 'member-1',
  location: 'Zoom',
  startTime: new Date('2026-08-01T17:00:00.000Z'),
  endTime: new Date('2026-08-01T17:30:00.000Z'),
  capacity: 2,
  signups: [],
  member: { fullName: 'Alice', email: 'alice@example.com' },
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

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
    prisma.recruitingCycle.findFirst.mockResolvedValue(null);
    prisma.meetingSignup.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.id === CANDIDATE.id || where.email === CANDIDATE.email) return CANDIDATE;
      return null;
    });
  });

  async function post(endpoint, body, token = tokenFor(CANDIDATE)) {
    return fetch(`http://localhost:${port}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  describe('POST /api/meeting-slots/:id/signup', () => {
    it('returns calendar sync warning when signup succeeds but calendar sync fails', async () => {
      prisma.meetingSlot.findUnique.mockResolvedValue(SLOT);
      prisma.meetingSignup.create.mockResolvedValue({ id: 'signup-1', slotId: 'slot-1' });
      syncMeetingSlotCalendar.mockResolvedValue({
        success: false,
        status: 'FAILED',
        error: 'Google is down',
        eventId: null,
      });

      const res = await post('/api/meeting-slots/slot-1/signup', {});

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.calendarSync.warning).toBe('Google is down');
      expect(body.calendarSync.status).toBe('FAILED');
    });

    it('returns no warning when calendar sync succeeds', async () => {
      prisma.meetingSlot.findUnique.mockResolvedValue(SLOT);
      prisma.meetingSignup.create.mockResolvedValue({ id: 'signup-1', slotId: 'slot-1' });
      syncMeetingSlotCalendar.mockResolvedValue({ success: true, status: 'SYNCED', eventId: 'evt-1' });

      const res = await post('/api/meeting-slots/slot-1/signup', {});

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.calendarSync.warning).toBeNull();
      expect(body.calendarSync.status).toBe('SYNCED');
    });
  });
});
