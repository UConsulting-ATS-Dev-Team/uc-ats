import prisma from '../../prismaClient.js';
import {
  createCalendarEvent,
  updateCalendarEvent,
  cancelCalendarEvent,
  isCalendarConfigured,
} from './calendar.js';

const DEFAULT_SLOT_DURATION_MS = 30 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

function buildSlotEventDetails(slot) {
  const start = slot.startTime ? new Date(slot.startTime) : null;
  const end = slot.endTime
    ? new Date(slot.endTime)
    : start
      ? new Date(start.getTime() + DEFAULT_SLOT_DURATION_MS)
      : null;

  return {
    eventName: `Get to Know UC - ${slot.member?.fullName?.trim() || 'UC Consulting Member'}`,
    eventLocation: slot.location,
    eventStartDate: start,
    eventEndDate: end,
  };
}

function getAttendeeEmails(slot) {
  const emails = new Set();
  if (slot.member?.email) {
    emails.add(slot.member.email.toLowerCase());
  }
  for (const signup of slot.signups || []) {
    if (signup?.email) {
      emails.add(signup.email.toLowerCase());
    }
  }
  return Array.from(emails);
}

function nextRetryAt(retryCount) {
  const delay = Math.min(60_000 * 2 ** retryCount, MAX_RETRY_DELAY_MS);
  return new Date(Date.now() + delay);
}

async function persistSyncStatus(slotId, data) {
  return prisma.meetingSlot.update({
    where: { id: slotId },
    data: {
      calendarSyncAt: new Date(),
      ...data,
    },
  });
}

async function recordFailure(slot, error, extra = {}) {
  const retryCount = (slot.calendarRetryCount || 0) + 1;
  const payload = {
    calendarSyncStatus: 'FAILED',
    calendarSyncError: String(error).slice(0, 1000),
    calendarRetryCount: retryCount,
    calendarRetryAt: nextRetryAt(retryCount - 1),
    ...extra,
  };
  try {
    await persistSyncStatus(slot.id, payload);
  } catch (dbError) {
    console.error(`[meetingSlotCalendar] failed to persist failure for slot ${slot.id}:`, dbError);
  }
}

export async function syncMeetingSlotCalendar(slotId, { force = false } = {}) {
  let slot;
  try {
    slot = await prisma.meetingSlot.findUnique({
      where: { id: slotId },
      include: {
        signups: true,
        member: { select: { fullName: true, email: true } },
      },
    });
  } catch (error) {
    console.error(`[meetingSlotCalendar] failed to load slot ${slotId}:`, error);
    return { success: false, status: 'FAILED', error: error.message || String(error) };
  }

  if (!slot) {
    return { success: false, status: 'FAILED', error: 'Slot not found' };
  }

  if (
    !force &&
    slot.calendarSyncStatus === 'FAILED' &&
    slot.calendarRetryAt &&
    new Date() < new Date(slot.calendarRetryAt)
  ) {
    return { success: false, status: 'FAILED', error: 'Retry backoff active' };
  }

  // Until GOOGLE_CALENDAR_ID is configured, do not call the provider.
  // Record the state so retries don't stack up and delivery stays gated.
  if (!isCalendarConfigured()) {
    await persistSyncStatus(slot.id, {
      calendarSyncStatus: 'NOT_CONFIGURED',
      calendarSyncError: null,
      calendarRetryCount: 0,
      calendarRetryAt: null,
    });
    return { success: true, status: 'NOT_CONFIGURED', eventId: slot.calendarEventId || null };
  }

  const eventDetails = buildSlotEventDetails(slot);
  const attendeeEmails = getAttendeeEmails(slot);
  let eventId = null;

  try {
    if (slot.calendarEventId) {
      eventId = await updateCalendarEvent(slot.calendarEventId, eventDetails, attendeeEmails);
      if (!eventId) {
        return { success: true, status: 'SYNCED', eventId: slot.calendarEventId };
      }
    } else {
      eventId = await createCalendarEvent(eventDetails, attendeeEmails);
      if (!eventId) {
        return { success: true, status: 'NOT_CONFIGURED', eventId: null };
      }
    }
  } catch (providerError) {
    await recordFailure(slot, providerError);
    return { success: false, status: 'FAILED', error: providerError.message || String(providerError) };
  }

  try {
    await persistSyncStatus(slot.id, {
      calendarEventId: eventId,
      calendarSyncStatus: 'SYNCED',
      calendarSyncError: null,
      calendarRetryCount: 0,
      calendarRetryAt: null,
    });
    return { success: true, status: 'SYNCED', eventId };
  } catch (dbError) {
    // If we just created a brand new event, try to roll it back so we don't
    // leave an orphan invite or create duplicates on the next retry.
    if (!slot.calendarEventId && eventId) {
      try {
        await cancelCalendarEvent(eventId);
      } catch (cancelError) {
        console.error(
          `[meetingSlotCalendar] failed to cancel orphan event ${eventId} after DB write failure for slot ${slot.id}:`,
          cancelError
        );
      }
    }
    await recordFailure(slot, `DB write failure: ${dbError.message || String(dbError)}`, {
      calendarEventId: slot.calendarEventId || eventId,
    });
    return { success: false, status: 'FAILED', error: dbError.message || String(dbError) };
  }
}

export async function cancelMeetingSlotCalendar(slotId) {
  let slot;
  try {
    slot = await prisma.meetingSlot.findUnique({
      where: { id: slotId },
      include: {
        signups: true,
        member: { select: { fullName: true, email: true } },
      },
    });
  } catch (error) {
    console.error(`[meetingSlotCalendar] failed to load slot ${slotId} for cancellation:`, error);
    return { success: false, status: 'FAILED', error: error.message || String(error) };
  }

  if (!slot) {
    return { success: false, status: 'FAILED', error: 'Slot not found' };
  }

  if (slot.calendarEventId) {
    try {
      await cancelCalendarEvent(slot.calendarEventId);
    } catch (providerError) {
      await recordFailure(slot, providerError);
      return { success: false, status: 'FAILED', error: providerError.message || String(providerError) };
    }
  }

  try {
    await persistSyncStatus(slot.id, {
      calendarSyncStatus: 'CANCELLED',
      calendarRetryCount: 0,
      calendarRetryAt: null,
    });
    return { success: true, status: 'CANCELLED' };
  } catch (dbError) {
    console.error(`[meetingSlotCalendar] failed to persist cancellation for slot ${slot.id}:`, dbError);
    return { success: false, status: 'FAILED', error: dbError.message || String(dbError) };
  }
}

// Exported for tests.
export { buildSlotEventDetails, getAttendeeEmails, nextRetryAt };
