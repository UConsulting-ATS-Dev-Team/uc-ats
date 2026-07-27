import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import memberRoutes from './member.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    meetingSlot: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    meetingSignup: {
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
      delete: vi.fn(),
    },
    meetingCommunication: { create: vi.fn() },
  },
}));

vi.mock('../services/slackService.js', () => ({
  sendSlackMessage: vi.fn().mockResolvedValue(),
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendMeetingCancellationEmail: vi.fn().mockResolvedValue(),
}));

vi.mock('../services/meetingComms.js', () => ({
  sendAndLogMeetingCommunication: vi.fn((fn) => fn()),
  MEETING_COMM_SUBJECTS: { CANCELLATION: 'CANCELLATION' },
}));

vi.mock('../services/google/meetingSlotCalendar.js', () => ({
  syncMeetingSlotCalendar: vi.fn(),
  cancelMeetingSlotCalendar: vi.fn(),
  calendarSyncResponse: vi.fn((result) => ({
    status: result.status,
    eventId: result.eventId || null,
    error: result.success ? null : result.error,
    warning: result.success ? null : result.error,
    retryAt: null,
  })),
}));

import prisma from '../prismaClient.js';
import { syncMeetingSlotCalendar, cancelMeetingSlotCalendar } from '../services/google/meetingSlotCalendar.js';

const MEMBER = { id: 'member-1', email: 'member@example.com', fullName: 'Member', role: 'MEMBER' };
const SLOT = {
  id: 'slot-1',
  memberId: MEMBER.id,
  location: 'Zoom',
  startTime: new Date('2026-08-01T17:00:00.000Z'),
  endTime: new Date('2026-08-01T17:30:00.000Z'),
  capacity: 2,
  signups: [],
  calendarEventId: 'evt-1',
  calendarSyncStatus: 'SYNCED',
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

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
    prisma.user.findUnique.mockImplementation(({ where: { id } }) => {
      return id === MEMBER.id ? MEMBER : null;
    });
  });

  async function del(endpoint, token = tokenFor(MEMBER)) {
    const headers = { Authorization: `Bearer ${token}` };
    return fetch(`http://localhost:${port}${endpoint}`, { method: 'DELETE', headers });
  }

  async function post(endpoint, body, token = tokenFor(MEMBER)) {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    return fetch(`http://localhost:${port}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  describe('DELETE /api/member/meeting-slots/:id', () => {
    it('blocks deletion and returns sync state when calendar cancellation fails', async () => {
      prisma.meetingSlot.findUnique.mockResolvedValue(SLOT);
      cancelMeetingSlotCalendar.mockResolvedValue({
        success: false,
        status: 'CANCEL_PENDING',
        error: 'Google is down',
        eventId: 'evt-1',
      });

      const res = await del('/api/member/meeting-slots/slot-1');
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body.calendarSync.status).toBe('CANCEL_PENDING');
      expect(body.calendarSync.error).toBe('Google is down');
      expect(prisma.meetingSlot.delete).not.toHaveBeenCalled();
    });

    it('deletes the slot when calendar cancellation succeeds', async () => {
      prisma.meetingSlot.findUnique.mockResolvedValue({ ...SLOT, signups: [] });
      cancelMeetingSlotCalendar.mockResolvedValue({ success: true, status: 'CANCELLED', eventId: null });
      prisma.$transaction = vi.fn((cb) => cb(prisma));

      const res = await del('/api/member/meeting-slots/slot-1');

      expect(res.status).toBe(200);
      expect(cancelMeetingSlotCalendar).toHaveBeenCalledWith('slot-1');
    });
  });

  describe('POST /api/member/meeting-slots/:id/retry-calendar', () => {
    it('re-cancels and deletes a CANCEL_PENDING slot', async () => {
      prisma.meetingSlot.findUnique.mockResolvedValue({ ...SLOT, calendarSyncStatus: 'CANCEL_PENDING' });
      cancelMeetingSlotCalendar.mockResolvedValue({ success: true, status: 'CANCELLED', eventId: null });
      prisma.$transaction = vi.fn((cb) => cb(prisma));

      const res = await post('/api/member/meeting-slots/slot-1/retry-calendar');

      expect(res.status).toBe(200);
      expect(cancelMeetingSlotCalendar).toHaveBeenCalledWith('slot-1');
      expect(prisma.meetingSlot.delete).toHaveBeenCalledWith({ where: { id: 'slot-1' } });
    });

    it('returns sync state when retrying a failed sync', async () => {
      prisma.meetingSlot.findUnique.mockResolvedValue({ ...SLOT, calendarSyncStatus: 'FAILED' });
      syncMeetingSlotCalendar.mockResolvedValue({ success: true, status: 'SYNCED', eventId: 'evt-1' });

      const res = await post('/api/member/meeting-slots/slot-1/retry-calendar');

      expect(res.status).toBe(200);
      expect(syncMeetingSlotCalendar).toHaveBeenCalledWith('slot-1', { force: true });
    });
  });
});
