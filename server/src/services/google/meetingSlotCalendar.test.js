import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  syncMeetingSlotCalendar,
  cancelMeetingSlotCalendar,
  buildSlotEventDetails,
  getAttendeeEmails,
  deriveCalendarEventId,
  deriveMeetingSlotId,
  calendarSyncResponse,
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

const SLOT_ID = '550e8400-e29b-41d4-a716-446655440000';
const DERIVED_EVENT_ID = SLOT_ID.toLowerCase().replace(/-/g, '');

const baseSlot = {
  id: SLOT_ID,
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

  describe('deriveCalendarEventId', () => {
    it('derives a base32hex-compatible id from a slot uuid', () => {
      const id = deriveCalendarEventId(SLOT_ID);
      expect(id).toBe(DERIVED_EVENT_ID);
      expect(id).toMatch(/^[a-v0-9]+$/);
      expect(id.length).toBeGreaterThanOrEqual(5);
    });

    it('removes invalid characters from a non-uuid id', () => {
      const id = deriveCalendarEventId('gtkuc_abc123-WXYZ');
      expect(id).toBe('gtkucabc123');
    });
  });

  describe('deriveMeetingSlotId', () => {
    it('returns a stable UUID from the same request fields', () => {
      const params = { memberId: 'member-1', location: 'Zoom', startTime: '2026-08-01T10:00', endTime: '2026-08-01T10:30', capacity: 2 };
      const a = deriveMeetingSlotId(params);
      const b = deriveMeetingSlotId(params);
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('produces different ids for different request fields', () => {
      const base = { memberId: 'member-1', location: 'Zoom', startTime: '2026-08-01T10:00', endTime: '2026-08-01T10:30', capacity: 2 };
      const a = deriveMeetingSlotId(base);
      const b = deriveMeetingSlotId({ ...base, location: 'Kerckhoff' });
      expect(a).not.toBe(b);
    });
  });

  describe('calendarSyncResponse', () => {
    it('returns a warning for a failed sync', () => {
      const result = calendarSyncResponse({ success: false, status: 'FAILED', error: 'Google is down', retryAt: null });
      expect(result.warning).toBe('Google is down');
      expect(result.error).toBe('Google is down');
    });

    it('returns no warning for a successful sync', () => {
      const result = calendarSyncResponse({ success: true, status: 'SYNCED', eventId: 'evt-1' });
      expect(result.warning).toBeNull();
      expect(result.error).toBeNull();
    });
  });

  describe('syncMeetingSlotCalendar', () => {
    it('creates a calendar event with a deterministic id when no eventId is stored', async () => {
      const signup = { email: 'Candidate@example.com', fullName: 'Candidate One' };
      slotState = makeSlot({ signups: [signup] });
      updateCalendarEvent.mockResolvedValue(DERIVED_EVENT_ID);

      const result = await syncMeetingSlotCalendar(SLOT_ID);

      expect(result).toEqual({ success: true, status: 'SYNCED', eventId: DERIVED_EVENT_ID });
      expect(updateCalendarEvent).toHaveBeenCalledOnce();
      expect(updateCalendarEvent).toHaveBeenCalledWith(DERIVED_EVENT_ID, expect.any(Object), [
        'alice@example.com',
        'candidate@example.com',
      ]);
      expect(createCalendarEvent).not.toHaveBeenCalled();

      const [, details] = updateCalendarEvent.mock.calls[0];
      expect(details.eventName).toContain('Alice Anderson');
      expect(details.eventLocation).toBe('Zoom');
      expect(new Date(details.eventStartDate).toISOString()).toBe(slotState.startTime.toISOString());
      expect(new Date(details.eventEndDate).toISOString()).toBe(slotState.endTime.toISOString());

      expect(prisma.meetingSlot.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: SLOT_ID },
          data: expectSyncState('SYNCED', {
            calendarEventId: DERIVED_EVENT_ID,
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

      const result = await syncMeetingSlotCalendar(SLOT_ID);

      expect(result).toEqual({ success: true, status: 'SYNCED', eventId: 'evt-1' });
      expect(updateCalendarEvent).toHaveBeenCalledWith('evt-1', expect.any(Object), [
        'alice@example.com',
        'bob@example.com',
      ]);
    });

    it('is idempotent across repeated sync calls by reusing the deterministic eventId', async () => {
      slotState = makeSlot();
      updateCalendarEvent.mockResolvedValue(DERIVED_EVENT_ID);

      await syncMeetingSlotCalendar(SLOT_ID);
      await syncMeetingSlotCalendar(SLOT_ID);

      expect(updateCalendarEvent).toHaveBeenCalledTimes(2);
      expect(updateCalendarEvent).toHaveBeenNthCalledWith(1, DERIVED_EVENT_ID, expect.any(Object), [
        'alice@example.com',
      ]);
      expect(updateCalendarEvent).toHaveBeenNthCalledWith(2, DERIVED_EVENT_ID, expect.any(Object), [
        'alice@example.com',
      ]);
      expect(createCalendarEvent).not.toHaveBeenCalled();
    });

    it('creates only one provider event when state writes fail after provider success and retry', async () => {
      slotState = makeSlot();
      updateCalendarEvent.mockResolvedValue(DERIVED_EVENT_ID);
      let updateCall = 0;
      prisma.meetingSlot.update.mockImplementation(({ data }) => {
        updateCall += 1;
        throw new Error('DB is locked');
      });

      const first = await syncMeetingSlotCalendar(SLOT_ID);
      expect(first.success).toBe(false);
      expect(first.status).toBe('FAILED');
      expect(first.eventId).toBe(DERIVED_EVENT_ID);
      expect(updateCalendarEvent).toHaveBeenCalledTimes(1);
      expect(cancelCalendarEvent).not.toHaveBeenCalled();

      // Retry: provider still sees the same id, so it patches instead of creating.
      const second = await syncMeetingSlotCalendar(SLOT_ID, { force: true });
      expect(second.success).toBe(false);
      expect(second.status).toBe('FAILED');
      expect(second.eventId).toBe(DERIVED_EVENT_ID);
      expect(updateCalendarEvent).toHaveBeenCalledTimes(2);
      expect(createCalendarEvent).not.toHaveBeenCalled();
    });

    it('retries after a provider failure and resets state on success', async () => {
      slotState = makeSlot();
      updateCalendarEvent.mockRejectedValueOnce(new Error('Google is down')).mockResolvedValueOnce(DERIVED_EVENT_ID);

      const first = await syncMeetingSlotCalendar(SLOT_ID);
      expect(first.success).toBe(false);
      expect(first.status).toBe('FAILED');
      expect(slotState.calendarRetryCount).toBe(1);
      expect(slotState.calendarSyncStatus).toBe('FAILED');
      expect(slotState.calendarRetryAt).toBeInstanceOf(Date);

      const second = await syncMeetingSlotCalendar(SLOT_ID, { force: true });
      expect(second).toEqual({ success: true, status: 'SYNCED', eventId: DERIVED_EVENT_ID });
      expect(slotState.calendarRetryCount).toBe(0);
      expect(slotState.calendarRetryAt).toBeNull();
    });

    it('returns a new eventId when update falls back to a recreate', async () => {
      slotState = makeSlot({ calendarEventId: 'evt-gone', signups: [{ email: 'cara@example.com' }] });
      updateCalendarEvent.mockResolvedValue('evt-new');

      const result = await syncMeetingSlotCalendar(SLOT_ID);

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

      const withoutForce = await syncMeetingSlotCalendar(SLOT_ID);
      expect(withoutForce.success).toBe(false);
      expect(withoutForce.error).toMatch(/backoff/i);
      expect(updateCalendarEvent).not.toHaveBeenCalled();
      expect(createCalendarEvent).not.toHaveBeenCalled();

      updateCalendarEvent.mockResolvedValue(DERIVED_EVENT_ID);
      const withForce = await syncMeetingSlotCalendar(SLOT_ID, { force: true });
      expect(withForce.success).toBe(true);
      expect(updateCalendarEvent).toHaveBeenCalledOnce();
    });

    it('marks NOT_CONFIGURED and does not call the provider when calendar is not set up and no event exists', async () => {
      isCalendarConfigured.mockReturnValue(false);

      const result = await syncMeetingSlotCalendar(SLOT_ID);

      expect(result).toEqual({ success: true, status: 'NOT_CONFIGURED', eventId: null });
      expect(updateCalendarEvent).not.toHaveBeenCalled();
      expect(createCalendarEvent).not.toHaveBeenCalled();
      expect(prisma.meetingSlot.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ calendarSyncStatus: 'NOT_CONFIGURED' }),
        })
      );
    });

    it('fails when calendar is not configured but a provider event id is already stored', async () => {
      slotState = makeSlot({ calendarEventId: 'evt-existing' });
      isCalendarConfigured.mockReturnValue(false);

      const result = await syncMeetingSlotCalendar(SLOT_ID);

      expect(result.success).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(result.error).toMatch(/not configured/i);
      expect(result.eventId).toBe('evt-existing');
      expect(slotState.calendarSyncStatus).toBe('FAILED');
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

      const result = await cancelMeetingSlotCalendar(SLOT_ID);

      expect(result).toEqual({ success: true, status: 'CANCELLED', eventId: null });
      expect(cancelCalendarEvent).toHaveBeenCalledWith('evt-cancel');
      expect(prisma.meetingSlot.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            calendarSyncStatus: 'CANCELLED',
            calendarEventId: null,
          }),
        })
      );
    });

    it('succeeds when there is no calendar event to cancel', async () => {
      slotState = makeSlot({ calendarEventId: null });
      // Derive deterministic id from slot for the provider call.
      cancelCalendarEvent.mockResolvedValue();

      const result = await cancelMeetingSlotCalendar(SLOT_ID);

      expect(result).toEqual({ success: true, status: 'CANCELLED', eventId: null });
      expect(cancelCalendarEvent).toHaveBeenCalledWith(DERIVED_EVENT_ID);
    });

    it('records CANCEL_PENDING and retains the provider event id when cancellation fails', async () => {
      slotState = makeSlot({ calendarEventId: 'evt-cancel' });
      cancelCalendarEvent.mockRejectedValue(new Error('Google is down'));

      const result = await cancelMeetingSlotCalendar(SLOT_ID);

      expect(result.success).toBe(false);
      expect(result.status).toBe('CANCEL_PENDING');
      expect(result.eventId).toBe('evt-cancel');
      expect(slotState.calendarSyncStatus).toBe('CANCEL_PENDING');
      expect(slotState.calendarEventId).toBe('evt-cancel');
      expect(slotState.calendarRetryCount).toBe(1);
    });

    it('records CANCEL_PENDING when calendar is not configured but a provider event id is stored', async () => {
      slotState = makeSlot({ calendarEventId: 'evt-cancel' });
      isCalendarConfigured.mockReturnValue(false);

      const result = await cancelMeetingSlotCalendar(SLOT_ID);

      expect(result.success).toBe(false);
      expect(result.status).toBe('CANCEL_PENDING');
      expect(result.error).toMatch(/not configured/i);
      expect(result.eventId).toBe('evt-cancel');
      expect(cancelCalendarEvent).not.toHaveBeenCalled();
      expect(slotState.calendarSyncStatus).toBe('CANCEL_PENDING');
      expect(slotState.calendarEventId).toBe('evt-cancel');
    });
  });
});
