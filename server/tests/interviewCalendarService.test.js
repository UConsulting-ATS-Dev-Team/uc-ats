import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/prismaClient.js', () => ({
  default: {
    interview: { findUnique: vi.fn(), update: vi.fn() },
    user: { findMany: vi.fn() }
  }
}));

vi.mock('../src/services/google/calendar.js', () => ({
  deleteEventById: vi.fn(),
  insertEventWithId: vi.fn(),
  patchEventById: vi.fn(),
  isCalendarConfigured: vi.fn(() => true),
  resolveAttendees: (attendees) => attendees
}));

const prisma = (await import('../src/prismaClient.js')).default;
const { deleteEventById } = await import('../src/services/google/calendar.js');
const { cancelInterviewCalendarEvent } = await import('../src/services/interviewCalendar.js');

const INTERVIEW = { id: 'interview-1', calendarEventId: 'ucatsinterview1' };

const calendarError = (status) => Object.assign(new Error(`calendar ${status}`), { code: status });

describe('cancelInterviewCalendarEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.interview.findUnique.mockResolvedValue({ ...INTERVIEW });
  });

  test('reports FAILED and keeps the stored event ID when the provider rejects the cancellation', async () => {
    deleteEventById.mockRejectedValue(calendarError(403));

    const result = await cancelInterviewCalendarEvent(INTERVIEW.id);

    expect(result.status).toBe('FAILED');
    // The event ID must survive so the delete can be retried instead of orphaning a live invite.
    expect(result.calendarEventId).toBe(INTERVIEW.calendarEventId);
    expect(prisma.interview.update).toHaveBeenCalledTimes(1);
    const { data } = prisma.interview.update.mock.calls[0][0];
    expect(data.calendarSyncStatus).toBe('FAILED');
    expect(data.calendarSyncError).toMatch(/still hold this invite/);
    expect(data).not.toHaveProperty('calendarEventId');
  });

  test('treats an already-deleted provider event as cancelled', async () => {
    deleteEventById.mockRejectedValue(calendarError(410));

    const result = await cancelInterviewCalendarEvent(INTERVIEW.id);

    expect(result.status).toBe('CANCELLED');
    const { data } = prisma.interview.update.mock.calls[0][0];
    expect(data).toMatchObject({
      calendarEventId: null,
      calendarAttendees: [],
      calendarSyncStatus: 'CANCELLED',
      calendarSyncError: null
    });
  });

  test('cancels and clears the event on success', async () => {
    deleteEventById.mockResolvedValue({});

    const result = await cancelInterviewCalendarEvent(INTERVIEW.id);

    expect(result.status).toBe('CANCELLED');
    expect(deleteEventById).toHaveBeenCalledWith(INTERVIEW.calendarEventId);
    expect(prisma.interview.update.mock.calls[0][0].data.calendarEventId).toBeNull();
  });
});
