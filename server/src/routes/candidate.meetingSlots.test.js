import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import candidateRoutes from './candidate.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    meetingSignup: { findMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
    meetingSlot: { findUnique: vi.fn() },
  },
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendMeetingSignupConfirmation: vi.fn().mockResolvedValue(),
  sendMeetingSignupNotification: vi.fn().mockResolvedValue(),
  sendMeetingCancellationEmail: vi.fn().mockResolvedValue(),
  sendMeetingCancellationToMember: vi.fn().mockResolvedValue(),
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

vi.mock('../services/meetingBooking.js', () => ({
  createMeetingSignup: vi.fn(),
  MeetingBookingConflictError: class extends Error {
    constructor(message, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

import prisma from '../prismaClient.js';
import { syncMeetingSlotCalendar } from '../services/google/meetingSlotCalendar.js';
import { createMeetingSignup, MeetingBookingConflictError } from '../services/meetingBooking.js';

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

describe('candidate meeting slot routes', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api', candidateRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    createMeetingSignup.mockResolvedValue({
      signup: { id: 'signup-1', slotId: 'slot-1' },
      slot: SLOT,
    });
    prisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.id === CANDIDATE.id || where.email === CANDIDATE.email) return CANDIDATE;
      return null;
    });
    syncMeetingSlotCalendar.mockResolvedValue({ success: true, status: 'SYNCED', eventId: 'evt-1' });
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

  describe('POST /api/my-meeting-signups', () => {
    it('creates a signup, syncs calendar, and returns sync state', async () => {
      const res = await post('/api/my-meeting-signups', { slotId: 'slot-1' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.calendarSync.status).toBe('SYNCED');
      expect(createMeetingSignup).toHaveBeenCalledWith({
        slotId: 'slot-1',
        fullName: CANDIDATE.fullName,
        email: CANDIDATE.email,
        studentId: CANDIDATE.studentId,
      });
    });

    it('returns the booking conflict status and message from the helper', async () => {
      createMeetingSignup.mockRejectedValue(new MeetingBookingConflictError('This time slot is full'));

      const res = await post('/api/my-meeting-signups', { slotId: 'slot-1' });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('This time slot is full');
    });

    it('returns 409 when booking hits a serialization conflict', async () => {
      const err = new Error('Transaction conflict');
      err.code = 'P2034';
      createMeetingSignup.mockRejectedValue(err);

      const res = await post('/api/my-meeting-signups', { slotId: 'slot-1' });

      expect(res.status).toBe(409);
    });
  });
});
