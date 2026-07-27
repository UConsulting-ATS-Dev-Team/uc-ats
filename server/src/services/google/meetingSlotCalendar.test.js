import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  syncMeetingSlotCalendar,
  cancelMeetingSlotCalendar,
  buildSlotEventDetails,
  getAttendeeEmails,
} from './meetingSlotCalendar.js';
import {
  createCalendarEvent,
  updateCalendarEvent,
  cancelCalendarEvent,
  isCalendarConfigured,
} from './calendar.js';
import prisma from '../../prismaClient.js';

vi.mock('./calendar.js', () => ({
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  cancelCalendarEvent: vi.fn(),
  isCalendarConfigured: vi.fn().mockReturnValue(true),
}));

vi.mock('../../prismaClient.js', () => ({
  default: {
    meetingSlot: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const baseSlot = {
  id: 'slot-1',
  memberId: 'member-1',
  location: 'Zoom',
  startTime: new Date('2026-08-01T17:00:00.000Z'),
  endTime: new Date('2026-08-01T17:30:00.000Z'),
  capacity: 2,
  calendarEventId: null,
  calendarSyncStatus: 'PENDING',
  calendarSyncError: null,
  calendarSyncAt: null,
  calendarRetryCount: 0,
  calendarRetryAt: null,
  member: { fullName: 'Alice Anderson', email: 'alice@example.com' },
  signups: [],
};

function makeSlot(overrides = {}) {
  return { ...baseSlot, ...overrides, signups: overrides.signups ?? baseSlot.signups };
}

function expectSyncState(status, extra = {}) {
  return expect.objectContaining({
    calendarSyncStatus: status,
    calendarSyncAt: expect.any(Date),
    ...extra,
  });
}

describe('meetingSlotCalendar', () => {
  let slotState;

  beforeEach(() => {
    vi.clearAllMocks();
    isCalendarConfigured.mockReturnValue(true);

    slotState = makeSlot();
    prisma.meetingSlot.findUnique.mockImplementation(() =>
      Promise.resolve({ ...slotState, signups: [...slotState.signups] })
    );
    prisma.meetingSlot.update.mockImplementation(({ data }) => {
      slotState = { ...slotState, ...data };
      return Promise.resolve({ ...slotState });
    });
  });

  describe('syncMeetingSlotCalendar', () => {
    it('creates a calendar event when no eventId is stored', async () => {
      const signup = { email: 'Candidate@example.com', fullName: 'Candidate One' };
      slotState = makeSlot({ signups: [signup] });
      createCalendarEvent.mockResolvedValue('evt-123');

      const result = await syncMeetingSlotCalendar('slot-1');

      expect(result).toEqual({ success: true, status: 'SYNCED', eventId: 'evt-123' });
      expect(createCalendarEvent).toHaveBeenCalledOnce();
      const [details, attendees] = createCalendarEvent.mock.calls[0];
      expect(details.eventName).toContain('Alice Anderson');
      expect(details.eventLocation).toBe('Zoom');
      expect(new Date(details.eventStartDate).toISOString()).toBe(slotState.startTime.toISOString());
      expect(new Date(details.eventEndDate).toISOString()).toBe(slotState.endTime.toISOString());
      expect(attendees).toEqual(['alice@example.com', 'candidate@example.com']);

      expect(prisma.meetingSlot.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'slot-1' },
          data: expectSyncState('SYNCED', {
            calendarEventId: 'evt-123',
            calendarSyncError: null,
            calendarRetryCount: 0,
            calendarRetryAt: null,
          }),
        })
      );
    });

    it('updates the existing event when an eventId is already stored', async () => {
      slotState = makeSlot({
        calendarEventId: 'evt-1',
        signups: [{ email: 'bob@example.com' }],
      });
      updateCalendarEvent.mockResolvedValue('evt-1');

      const result = await syncMeetingSlotCalendar('slot-1');

      expect(result).toEqual({ success: true, status: 'SYNCED', eventId: 'evt-1' });
      expect(updateCalendarEvent).toHaveBeenCalledWith('evt-1', expect.any(Object), [
        'alice@example.com',
        'bob@example.com',
      ]);
      expect(createCalendarEvent).not.toHaveBeenCalled();
    });

    it('is idempotent across repeated sync calls by reusing the stored eventId', async () => {
      slotState = makeSlot();
      createCalendarEvent.mockResolvedValue('evt-created');
      updateCalendarEvent.mockResolvedValue('evt-created');

      await syncMeetingSlotCalendar('slot-1');
      await syncMeetingSlotCalendar('slot-1');

      expect(createCalendarEvent).toHaveBeenCalledTimes(1);
      expect(updateCalendarEvent).toHaveBeenCalledTimes(1);
      expect(updateCalendarEvent).toHaveBeenCalledWith('evt-created', expect.any(Object), [
        'alice@example.com',
      ]);
    });

    it('retries after a provider failure and resets state on success', async () => {
      slotState = makeSlot();
      createCalendarEvent
        .mockRejectedValueOnce(new Error('Google is down'))
        .mockResolvedValueOnce('evt-retry');

      const first = await syncMeetingSlotCalendar('slot-1');
      expect(first.success).toBe(false);
      expect(first.status).toBe('FAILED');
      expect(slotState.calendarRetryCount).toBe(1);
      expect(slotState.calendarSyncStatus).toBe('FAILED');
      expect(slotState.calendarRetryAt).toBeInstanceOf(Date);

      const second = await syncMeetingSlotCalendar('slot-1', { force: true });
      expect(second).toEqual({ success: true, status: 'SYNCED', eventId: 'evt-retry' });
      expect(slotState.calendarRetryCount).toBe(0);
      expect(slotState.calendarRetryAt).toBeNull();
    });

    it('returns a new eventId when update falls back to a recreate', async () => {
      slotState = makeSlot({ calendarEventId: 'evt-gone', signups: [{ email: 'cara@example.com' }] });
      updateCalendarEvent.mockResolvedValue('evt-new');

      const result = await syncMeetingSlotCalendar('slot-1');

      expect(updateCalendarEvent).toHaveBeenCalledWith('evt-gone', expect.any(Object), [
        'alice@example.com',
        'cara@example.com',
      ]);
      expect(result.eventId).toBe('evt-new');
      expect(prisma.meetingSlot.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ calendarEventId: 'evt-new' }),
        })
      );
    });

    it('respects retry backoff unless force is set', async () => {
      slotState = makeSlot({
        calendarSyncStatus: 'FAILED',
        calendarRetryAt: new Date(Date.now() + 60_000),
      });

      const withoutForce = await syncMeetingSlotCalendar('slot-1');
      expect(withoutForce.success).toBe(false);
      expect(withoutForce.error).toMatch(/backoff/i);
      expect(createCalendarEvent).not.toHaveBeenCalled();
      expect(updateCalendarEvent).not.toHaveBeenCalled();

      createCalendarEvent.mockResolvedValue('evt-forced');
      const withForce = await syncMeetingSlotCalendar('slot-1', { force: true });
      expect(withForce.success).toBe(true);
      expect(createCalendarEvent).toHaveBeenCalledOnce();
    });

    it('marks NOT_CONFIGURED and does not call the provider when calendar is not set up', async () => {
      isCalendarConfigured.mockReturnValue(false);

      const result = await syncMeetingSlotCalendar('slot-1');

      expect(result).toEqual({ success: true, status: 'NOT_CONFIGURED', eventId: null });
      expect(createCalendarEvent).not.toHaveBeenCalled();
      expect(updateCalendarEvent).not.toHaveBeenCalled();
      expect(prisma.meetingSlot.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ calendarSyncStatus: 'NOT_CONFIGURED' }),
        })
      );
    });

    it('rolls back a newly created event when the DB write fails', async () => {
      slotState = makeSlot();
      createCalendarEvent.mockResolvedValue('evt-orphan');

      let updateCall = 0;
      prisma.meetingSlot.update.mockImplementation(({ data }) => {
        updateCall += 1;
        if (updateCall === 1) {
          throw new Error('DB is locked');
        }
        slotState = { ...slotState, ...data };
        return Promise.resolve({ ...slotState });
      });

      const result = await syncMeetingSlotCalendar('slot-1');

      expect(result.success).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(createCalendarEvent).toHaveBeenCalledOnce();
      expect(cancelCalendarEvent).toHaveBeenCalledWith('evt-orphan');
      expect(prisma.meetingSlot.update).toHaveBeenCalledTimes(2);
      expect(slotState.calendarSyncStatus).toBe('FAILED');
      expect(slotState.calendarSyncError).toMatch(/DB is locked/);
    });

    it('builds a 30-minute end time when the slot has no end time', () => {
      const slot = makeSlot({ endTime: null });
      const details = buildSlotEventDetails(slot);
      const start = new Date(details.eventStartDate).getTime();
      const end = new Date(details.eventEndDate).getTime();
      expect(end - start).toBe(30 * 60 * 1000);
    });

    it('deduplicates attendee emails case-insensitively', () => {
      const slot = makeSlot({
        member: { fullName: 'Alice', email: 'ALICE@example.com' },
        signups: [{ email: 'alice@example.com' }, { email: 'BOB@example.com' }],
      });
      expect(getAttendeeEmails(slot)).toEqual(['alice@example.com', 'bob@example.com']);
    });
  });

  describe('cancelMeetingSlotCalendar', () => {
    it('cancels an existing event and records CANCELLED status', async () => {
      slotState = makeSlot({ calendarEventId: 'evt-cancel' });
      cancelCalendarEvent.mockResolvedValue();

      const result = await cancelMeetingSlotCalendar('slot-1');

      expect(result).toEqual({ success: true, status: 'CANCELLED' });
      expect(cancelCalendarEvent).toHaveBeenCalledWith('evt-cancel');
      expect(prisma.meetingSlot.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ calendarSyncStatus: 'CANCELLED' }),
        })
      );
    });

    it('succeeds when there is no calendar event to cancel', async () => {
      slotState = makeSlot({ calendarEventId: null });

      const result = await cancelMeetingSlotCalendar('slot-1');

      expect(result).toEqual({ success: true, status: 'CANCELLED' });
      expect(cancelCalendarEvent).not.toHaveBeenCalled();
    });

    it('records failure when the provider cancellation fails', async () => {
      slotState = makeSlot({ calendarEventId: 'evt-cancel' });
      cancelCalendarEvent.mockRejectedValue(new Error('Google is down'));

      const result = await cancelMeetingSlotCalendar('slot-1');

      expect(result.success).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(slotState.calendarSyncStatus).toBe('FAILED');
      expect(slotState.calendarRetryCount).toBe(1);
    });
  });
});
